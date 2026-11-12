import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cgroupIn, freeze, heldWord, killLeftOver, only, reclaim, signal, thaw, tree } from "../src/discordfreeze.ts";
import { proc } from "@harbor/os";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const root = "/sys/fs/cgroup";

test("reads_the_unified_cgroup_line: reads the unified cgroup line", () => {
  expect(cgroupIn("0::/user.slice/a.scope\n", root)).toBe(join(root, "user.slice/a.scope"));
  expect(cgroupIn("1:name=x:/y\n0::/z\n", root)).toBe(join(root, "z"));
  expect(cgroupIn("0::/\n", root)).toBeUndefined();
  expect(cgroupIn("1:name=x:/y\n", root)).toBeUndefined();
});

test("a_cgroup_with_anyone_else_in_it_isnt_ours: a cgroup with anyone else in it isn't ours", () => {
  expect(only("10\n11\n", [10, 11, 12])).toBe(true);
  expect(only("10\n99\n", [10, 11])).toBe(false);
});

const state = (p: number): string => proc.stat(p)?.state ?? "";

test("signals_hold_a_tree_and_let_it_go: signals hold a tree and let it go", async () => {
  const saved = process.env.HARBOR_DISCORD_NO_CGROUP;
  process.env.HARBOR_DISCORD_NO_CGROUP = "1";
  const c = spawn("sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
  const leader = c.pid ?? 0;
  try {
    await sleep(150);
    const pids = tree(leader);
    expect(pids.length).toBe(2);
    const held = await freeze(leader);
    expect(heldWord(held)).toBe("signals");
    await sleep(50);
    expect(pids.every((p) => state(p) === "T")).toBe(true);
    thaw(held);
    await sleep(50);
    expect(pids.every((p) => state(p) !== "T")).toBe(true);
  } finally {
    killLeftOver(leader);
    if (saved === undefined) delete process.env.HARBOR_DISCORD_NO_CGROUP;
    else process.env.HARBOR_DISCORD_NO_CGROUP = saved;
  }
  await new Promise((r) => c.once("exit", r));
  // The killed sleep can stay a zombie until whoever adopted it reaps it (on a sandbox whose init
  // doesn't, for good): dead all the same.
  const living = (): number[] =>
    tree(leader).filter((p) => {
      try {
        return state(p) !== "Z";
      } catch {
        return false;
      }
    });
  for (let i = 0; i < 20 && living().length > 0; i++) await sleep(50);
  expect(living()).toEqual([]);
});

test("freezing nothing is an error", async () => {
  await expect(freeze(2 ** 22 + 12345)).rejects.toThrow("nothing to freeze");
});

test("signal ignores processes that are gone", () => {
  signal([2 ** 22 + 54321], "SIGCONT");
});

let dir = "";
afterEach(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
  dir = "";
});

test("reclaim asks for a little at a time until little is left or it is told to stop", async () => {
  dir = mkdtempSync(join(tmpdir(), "hdfreeze-"));
  writeFileSync(join(dir, "memory.current"), String(500 << 20));
  const stop = { stopped: false };
  const run = reclaim({ kind: "cgroups", paths: [dir] }, stop);
  await sleep(150);
  expect(readFileSync(join(dir, "memory.reclaim"), "utf8")).toBe("32M");
  stop.stopped = true;
  await run;

  rmSync(join(dir, "memory.reclaim"));
  writeFileSync(join(dir, "memory.current"), String(1 << 20));
  await reclaim({ kind: "cgroups", paths: [dir] }, { stopped: false });
  expect(() => readFileSync(join(dir, "memory.reclaim"))).toThrow();
  await reclaim({ kind: "signals", pids: [] }, { stopped: false });
});
