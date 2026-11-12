import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive } from "../src/files.ts";
import { rolledBack, skipped } from "../src/install.ts";
import { readMeta, writeMeta, type Meta } from "../src/previewmeta.ts";
import { FAILED_LOG, START_LOG, captureStart } from "../src/startlog.ts";
import { ATTEMPT, START_LIMIT_MS, beginAttempt, confirmStart, failedStart, readAttempt, recoverUnconfirmed, watch } from "../src/startup.ts";
import { cleanup, configFor, makeInstall, tmp, type Install } from "./support.ts";

afterEach(cleanup);

function withPrevious(inst: Install, previous = "1.0.0"): void {
  const prev = join(inst.dir, ".previous");
  mkdirSync(prev);
  writeFileSync(join(prev, "harbor-app.js"), `export const meta = { version: "${previous}", minRuntime: "1.0.0" };`);
  writeFileSync(join(prev, "VERSION"), previous);
  writeFileSync(join(inst.dir, "VERSION"), "1.1.0");
}

const attempt = (pid: number, extra: Partial<Parameters<typeof beginAttempt>[1]> = {}) => ({ version: "1.1.0", pid, kind: "release" as const, args: [], id: "", ...extra });

test("a start is clean once it has lived a moment, and only for the process that began it", async () => {
  const inst = makeInstall();
  const cfg = configFor(inst, { sleep: async () => undefined });
  beginAttempt(cfg, attempt(process.pid));
  expect(readAttempt(inst.dir)?.stage).toBe("trying");
  expect(await confirmStart(cfg, 0)).toBe(true);
  expect(readAttempt(inst.dir)?.stage).toBe("ok");
  expect(await confirmStart(cfg, 0)).toBe(false);
  beginAttempt(cfg, attempt(process.pid + 1));
  expect(await confirmStart(cfg, 0)).toBe(false);
  expect(readAttempt(inst.dir)?.stage).toBe("trying");
});

test("a source build has no start to confirm", async () => {
  expect(await confirmStart(configFor(null), 0)).toBe(false);
  expect(recoverUnconfirmed(configFor(null))).toBeNull();
});

test("a failed release start goes back to the previous bundle, skips the version and says why", () => {
  const inst = makeInstall({ version: "1.1.0" });
  withPrevious(inst);
  const cfg = configFor(inst, { version: "1.1.0" });
  beginAttempt(cfg, attempt(4_000_000));
  const a = readAttempt(inst.dir);
  expect(a).not.toBeNull();
  expect(failedStart(cfg, a as NonNullable<typeof a>, "it exited while starting")).toBe("rolled-back");
  expect(readFileSync(join(inst.dir, "VERSION"), "utf8")).toBe("1.0.0");
  expect(readFileSync(join(inst.dir, "harbor-app.js"), "utf8")).toContain('"1.0.0"');
  expect(skipped(cfg, "1.1.0")).toBe(true);
  expect(rolledBack(cfg)).toMatchObject({ version: "1.1.0", restored: "1.0.0", why: "it exited while starting" });
  expect(existsSync(join(inst.dir, ATTEMPT))).toBe(false);
});

test("a failed start with nothing earlier to go back to is only recorded", () => {
  const inst = makeInstall({ version: "1.1.0" });
  const logs: string[] = [];
  const cfg = configFor(inst, { version: "1.1.0", log: (m) => void logs.push(m) });
  beginAttempt(cfg, attempt(4_000_000));
  const a = readAttempt(inst.dir);
  expect(failedStart(cfg, a as NonNullable<typeof a>, "it exited while starting")).toBe("nothing-to-fall-back-to");
  expect(readFileSync(join(inst.dir, "harbor-app.js"), "utf8")).toContain('"1.1.0"');
  expect(logs[0]).toContain("no earlier version");
  expect(existsSync(join(inst.dir, ATTEMPT))).toBe(false);
});

const previewMeta = (over: Partial<Meta> = {}): Meta => ({ id: "abc", sha256: "00", version: "1.1.0", note: "", from: "", at: 5, stage: "trying", why: "", shown_ms: 0, ...over });

test("a failed preview is marked failed and the release stays untouched", () => {
  const inst = makeInstall();
  withPrevious(inst);
  const cfg = configFor(inst);
  writeMeta(inst.dir, previewMeta());
  beginAttempt(cfg, attempt(4_000_000, { kind: "preview", id: "abc" }));
  const a = readAttempt(inst.dir) as NonNullable<ReturnType<typeof readAttempt>>;
  expect(failedStart(cfg, a, "it showed no frame in time")).toBe("preview-failed");
  expect(readMeta(inst.dir)).toMatchObject({ stage: "failed", why: "it showed no frame in time" });
  expect(existsSync(join(inst.dir, ".previous", "harbor-app.js"))).toBe(true);
  expect(skipped(cfg, "1.1.0")).toBe(false);
});

test("a preview's first frame and verdict are written when its start is confirmed", async () => {
  const inst = makeInstall();
  const cfg = configFor(inst, { sleep: async () => undefined, now: () => 1234 });
  writeMeta(inst.dir, previewMeta());
  beginAttempt(cfg, attempt(process.pid, { kind: "preview", id: "abc" }));
  expect(await confirmStart(cfg, 0)).toBe(true);
  expect(readMeta(inst.dir)).toMatchObject({ stage: "ok", shown_ms: 1234 });
});

test("an attempt nobody confirmed and whose process is gone counts as failed at the next start", () => {
  const inst = makeInstall({ version: "1.1.0" });
  withPrevious(inst);
  const cfg = configFor(inst, { version: "1.1.0" });
  beginAttempt(cfg, attempt(4_000_000));
  expect(recoverUnconfirmed(cfg)).toBe("rolled-back");
  expect(skipped(cfg, "1.1.0")).toBe(true);
});

test("a start still going on is left alone, and so is one that was confirmed", async () => {
  const inst = makeInstall({ version: "1.1.0" });
  withPrevious(inst);
  const child = Bun.spawn(["sleep", "30"]);
  try {
    const cfg = configFor(inst, { version: "1.1.0", now: () => 1000 });
    writeFileSync(join(inst.dir, ATTEMPT), JSON.stringify({ ...attempt(child.pid), at: 1000, stage: "trying" }));
    expect(recoverUnconfirmed(cfg)).toBeNull();
    writeFileSync(join(inst.dir, ATTEMPT), JSON.stringify({ ...attempt(4_000_000), at: 1000, stage: "ok" }));
    expect(recoverUnconfirmed(cfg)).toBeNull();
    expect(skipped(cfg, "1.1.0")).toBe(false);
  } finally {
    child.kill();
  }
});

test("the watchdog lets a clean start be, and acts when the process dies first", async () => {
  const inst = makeInstall({ version: "1.1.0" });
  withPrevious(inst);
  const cfg = configFor(inst, { version: "1.1.0", sleep: async () => undefined });
  const started: string[][] = [];
  const deps = { relaunch: (a: string[]) => void started.push(a), kill: () => undefined };

  const child = Bun.spawn(["sleep", "30"]);
  beginAttempt(cfg, attempt(child.pid, { args: ["--background"] }));
  let looks = 0;
  const confirming = configFor(inst, {
    version: "1.1.0",
    sleep: async () => {
      if (++looks === 3) writeFileSync(join(inst.dir, ATTEMPT), JSON.stringify({ ...readAttempt(inst.dir), stage: "ok" }));
    },
  });
  expect(await watch(confirming, child.pid, deps)).toBe(0);
  expect(started).toEqual([]);
  expect(readFileSync(join(inst.dir, "VERSION"), "utf8")).toBe("1.1.0");

  beginAttempt(cfg, attempt(child.pid, { args: ["--background"] }));
  let killed = 0;
  child.kill();
  await child.exited;
  expect(alive(child.pid)).toBe(false);
  expect(await watch(cfg, child.pid, { relaunch: deps.relaunch, kill: () => void killed++ })).toBe(0);
  expect(killed).toBe(0);
  expect(started).toEqual([["--background"]]);
  expect(readFileSync(join(inst.dir, "VERSION"), "utf8")).toBe("1.0.0");
  expect(rolledBack(cfg)?.why).toBe("it exited while starting");
});

test("the watchdog kills a start that shows no frame in time and starts the previous bundle", async () => {
  const inst = makeInstall({ version: "1.1.0" });
  withPrevious(inst);
  let clock = 0;
  const child = Bun.spawn(["sleep", "60"]);
  const cfg = configFor(inst, {
    version: "1.1.0",
    now: () => clock,
    sleep: async (ms) => {
      clock += ms === 200 ? START_LIMIT_MS / 100 : ms;
    },
  });
  beginAttempt(cfg, attempt(child.pid));
  const started: string[][] = [];
  let kills = 0;
  await watch(cfg, child.pid, {
    relaunch: (a) => void started.push(a),
    kill: (pid) => {
      kills++;
      process.kill(pid, "SIGKILL");
    },
  });
  await child.exited;
  expect(kills).toBe(1);
  expect(started.length).toBe(1);
  expect(rolledBack(cfg)?.why).toBe("it showed no frame in time");
  expect(skipped(cfg, "1.1.0")).toBe(true);
});

test("a watchdog for an attempt that was replaced does nothing", async () => {
  const inst = makeInstall();
  withPrevious(inst);
  const cfg = configFor(inst, { sleep: async () => undefined });
  beginAttempt(cfg, attempt(process.pid));
  const started: string[][] = [];
  expect(await watch(cfg, 4_000_000, { relaunch: (a) => void started.push(a), kill: () => undefined })).toBe(0);
  expect(started).toEqual([]);
  expect(skipped(cfg, "1.1.0")).toBe(false);
});

test("a failed start keeps what it wrote to stderr as failed-start.log, and rolled-back.json says where", () => {
  const inst = makeInstall({ version: "1.1.0" });
  withPrevious(inst);
  const cfg = configFor(inst, { version: "1.1.0" });
  writeFileSync(join(inst.dir, START_LOG), "error: Cannot find module 'x'\n");
  beginAttempt(cfg, attempt(4_000_000));
  expect(failedStart(cfg, readAttempt(inst.dir) as NonNullable<ReturnType<typeof readAttempt>>, "it exited while starting")).toBe("rolled-back");
  expect(rolledBack(cfg)).toMatchObject({ why: "it exited while starting", log: join(inst.dir, FAILED_LOG) });
  expect(readFileSync(join(inst.dir, FAILED_LOG), "utf8")).toBe("error: Cannot find module 'x'\n");
  expect(existsSync(join(inst.dir, START_LOG))).toBe(false);
});

test("the watchdog doesn't start again a release that failed with nothing to go back to", async () => {
  const inst = makeInstall({ version: "1.1.0" });
  const logs: string[] = [];
  const cfg = configFor(inst, { version: "1.1.0", sleep: async () => undefined, log: (m) => void logs.push(m) });
  writeFileSync(join(inst.dir, START_LOG), "boom\n");
  beginAttempt(cfg, attempt(4_000_000));
  const started: string[][] = [];
  expect(await watch(cfg, 4_000_000, { relaunch: (a) => void started.push(a), kill: () => undefined })).toBe(0);
  expect(started).toEqual([]);
  expect(logs[0]).toContain(`its errors are in ${join(inst.dir, FAILED_LOG)}`);
});

test("a start's stderr goes to start.log until it is confirmed, then back where it was", async () => {
  const dir = tmp();
  const code = `import { captureStart } from ${JSON.stringify(join(import.meta.dir, "..", "src", "startlog.ts"))};
let ok = false;
captureStart(${JSON.stringify(dir)}, () => ok);
console.error("while starting");
ok = true;
await Bun.sleep(800);
console.error("after the start");`;
  const p = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  const [err, exit] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  expect(exit).toBe(0);
  expect(readFileSync(join(dir, START_LOG), "utf8")).toBe("while starting\n");
  // Windows copies what Bun writes (no dup2 there): it still reaches the old stderr too.
  expect(err).toBe(process.platform === "win32" ? "while starting\nafter the start\n" : "after the start\n");
});

test("an error that ends a start before it is confirmed is in start.log, and the start still fails", async () => {
  for (const how of ["throw new Error('boom at start')", "Promise.reject(new Error('boom at start'))"]) {
    const dir = tmp();
    const code = `import { captureStart } from ${JSON.stringify(join(import.meta.dir, "..", "src", "startlog.ts"))};
captureStart(${JSON.stringify(dir)}, () => false);
setTimeout(() => { ${how}; }, 10);
setTimeout(() => process.exit(0), 3000);`;
    const p = Bun.spawn([process.execPath, "-e", code], { stdout: "ignore", stderr: "pipe" });
    const exit = await p.exited;
    expect(exit).toBe(1);
    expect(readFileSync(join(dir, START_LOG), "utf8")).toContain("boom at start");
  }
});
