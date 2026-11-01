import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Updater, backoffMs, installDue, news } from "../src/delivery.ts";
import { retryAfter } from "../src/extras.ts";
import { FakeHost, cleanup, configFor, makeInstall, makeKey, wait } from "./support.ts";

afterEach(cleanup);

const noWait = async (): Promise<void> => undefined;

async function rig(opts: { worker?: boolean } = {}) {
  const key = await makeKey();
  const host = new FakeHost();
  const sleeps: number[] = [];
  const swapped: string[] = [];
  const inst = makeInstall();
  const cfg = host.config(inst, key, {
    worker: opts.worker === false ? null : host.url,
    sleep: async (ms) => {
      sleeps.push(ms);
      await noWait();
    },
  });
  const updater = new Updater(cfg, { swap: (v) => void swapped.push(v) });
  return { key, host, inst, cfg, updater, sleeps, swapped };
}

test("news from other PCs: only a newer version than this one and than what was heard", () => {
  const ahead = "99.0.0";
  const more = "99.0.1";
  const cur = "1.0.0";
  expect(news({ version: cur, latest: ahead }, cur, null)).toBe(ahead);
  expect(news({ version: ahead, latest: null }, cur, null)).toBe(ahead);
  expect(news({ version: ahead, latest: more }, cur, null)).toBe(more);
  expect(news({ version: more, latest: ahead }, cur, null)).toBe(more);
  expect(news({ version: cur, latest: null }, cur, null)).toBeNull();
  expect(news({ version: "0.0.1", latest: cur }, cur, null)).toBeNull();
  expect(news({ version: cur, latest: ahead }, cur, ahead)).toBeNull();
  expect(news({ version: cur, latest: more }, cur, ahead)).toBe(more);
  expect(news(null, cur, null)).toBeNull();
  expect(news({ managed: true }, cur, null)).toBeNull();
  expect(news({ version: "garbage", latest: 7 }, cur, null)).toBeNull();
});

test("a failed install waits before it is tried again, and another release may work", () => {
  expect(installDue(null, "1.0.0", 0)).toBe(true);
  const failed = { version: "1.0.0", at: 1000 + retryAfter(1) };
  expect(installDue(failed, "1.0.0", 1000)).toBe(false);
  expect(installDue(failed, "1.0.0", 1000 + retryAfter(1) - 1000)).toBe(false);
  expect(installDue(failed, "1.0.0", 1000 + retryAfter(1))).toBe(true);
  expect(installDue(failed, "1.0.1", 1000)).toBe(true);
  expect(retryAfter(1)).toBeGreaterThanOrEqual(5 * 60 * 1000);
});

test("the long-poll backs off 5 s, 10 s, 20 s… up to 5 min, spread by chance", () => {
  const mid = () => 0.5;
  expect([1, 2, 3, 4].map((n) => backoffMs(n, mid))).toEqual([5000, 10000, 20000, 40000]);
  expect(backoffMs(30, mid)).toBe(300000);
  expect(backoffMs(1, () => 0)).toBe(4000);
  expect(backoffMs(1, () => 1)).toBe(6000);
});

test("a source build has nothing to offer or install", () => {
  const u = new Updater(configFor(null));
  const i = u.info();
  expect(i.version).toBe("1.0.0");
  expect(i.managed).toBe(false);
  expect(i.latest).toBeNull();
  expect(i.ready).toBe(false);
  expect(i.status).toContain("source");
  expect(i.auto).toBe(true);
  expect(i.preview_on).toBe(false);
  expect(i.preview).toBeNull();
  u.start();
  u.stop();
});

test("a release published while a PC waits is installed and swapped into at once", async () => {
  const { key, host, inst, updater, swapped } = await rig();
  updater.start();
  await wait(() => host.held() === 1);
  expect(host.waits).toEqual(["1.0.0"]);
  await host.publishTs(key, "1.1.0");
  host.answerWait(200, "1.1.0");
  await wait(() => swapped.length === 1);
  expect(swapped).toEqual(["1.1.0"]);
  expect(readInstalled(inst.dir)).toBe("1.1.0");
  expect(updater.state()).toEqual({ t: "installed", v: "1.1.0" });
  const i = updater.info();
  expect(i.ready).toBe(true);
  expect(i.latest).toBe("1.1.0");
  expect(i.status).toBe("1.1.0 installed, restarts into it");
  await wait(() => host.waits.length === 2);
  expect(host.waits[1]).toBe("1.1.0");
  updater.stop();
});

function readInstalled(dir: string): string {
  return readFileSync(join(dir, "VERSION"), "utf8");
}

test("a PC that wakes up behind catches up: the worker answers at once and the install follows", async () => {
  const { key, host, updater, swapped } = await rig();
  await host.publishTs(key, "1.3.0");
  host.workerAnswers.push({ status: 200, version: "1.3.0" });
  updater.start();
  await wait(() => swapped.length === 1);
  expect(swapped).toEqual(["1.3.0"]);
  updater.stop();
});

test("GitHub is asked on every start, with or without the worker", async () => {
  const { key, host, updater, swapped } = await rig({ worker: false });
  await host.publishTs(key, "1.1.0");
  updater.start();
  await wait(() => swapped.length === 1);
  expect(host.hits[0]).toBe("HEAD /o/r/releases/latest");
  expect(host.hits.some((h) => h.includes("/v1/release/wait"))).toBe(false);
  updater.stop();
});

test("a no-news answer (204) reconnects with the same version", async () => {
  const { host, updater } = await rig();
  host.workerAnswers.push({ status: 204 }, { status: 204 });
  updater.start();
  await wait(() => host.waits.length === 3);
  expect(host.waits).toEqual(["1.0.0", "1.0.0", "1.0.0"]);
  updater.stop();
});

test("when the worker is down the PC retries with growing waits and looks at GitHub meanwhile", async () => {
  const { key, host, updater, sleeps, swapped } = await rig();
  host.workerAnswers.push({ status: 500 }, { status: 502 }, { status: 503 });
  await host.publishTs(key, "1.1.0");
  host.latest = null;
  updater.start();
  await wait(() => host.waits.length === 4);
  expect(sleeps.filter((s) => s >= 5000 && s < 35000)).toEqual([5000, 10000, 20000]);
  expect(host.hits.filter((h) => h === "HEAD /o/r/releases/latest").length).toBeGreaterThanOrEqual(2);
  host.latest = "1.1.0";
  host.answerWait(200, "1.1.0");
  await wait(() => swapped.length === 1);
  updater.stop();
});

test("an answer that is not newer than what the PC has does not install, and waits a little", async () => {
  const { host, updater, sleeps, swapped } = await rig();
  host.workerAnswers.push({ status: 200, version: "1.0.0" });
  updater.start();
  await wait(() => host.waits.length === 2);
  expect(sleeps).toContain(5000);
  expect(swapped).toEqual([]);
  updater.stop();
});

test("news from another PC makes this one ask GitHub, once per version", async () => {
  const { key, host, updater, swapped } = await rig({ worker: false });
  await host.publishTs(key, "1.1.0", { setLatest: false });
  updater.peerNews({ version: "1.0.0", latest: null });
  await new Promise((r) => setTimeout(r, 50));
  expect(host.hits).toEqual([]);
  host.latest = "1.1.0";
  updater.peerNews({ version: "1.1.0", latest: null });
  await wait(() => swapped.length === 1);
  const asked = host.hits.filter((h) => h === "HEAD /o/r/releases/latest").length;
  updater.peerNews({ version: "1.1.0", latest: null });
  await new Promise((r) => setTimeout(r, 50));
  expect(host.hits.filter((h) => h === "HEAD /o/r/releases/latest").length).toBe(asked);
});

test("a version that was rolled back from is offered, not installed", async () => {
  const { key, host, inst, updater, swapped } = await rig({ worker: false });
  await host.publishTs(key, "1.1.0");
  writeFileSync(join(inst.dir, ".skip"), "1.1.0");
  await updater.githubCheck();
  expect(updater.state()).toEqual({ t: "available", v: "1.1.0" });
  expect(swapped).toEqual([]);
  expect(updater.info().skipped).toBe("1.1.0");
  await updater.installNow();
  expect(swapped).toEqual(["1.1.0"]);
});

test("an install that fails is reported and not tried again for a while", async () => {
  const { host, updater, swapped } = await rig({ worker: false });
  host.latest = "1.1.0";
  await updater.githubCheck();
  expect(updater.state().t).toBe("failed");
  expect(updater.info().error).toContain("harbor-app.json");
  expect(updater.info().status).toStartWith("update failed:");
  const hits = host.hits.length;
  await updater.onRelease("1.1.0");
  expect(host.hits.length).toBe(hits);
  expect(swapped).toEqual([]);
});

test("a release already installed on disk is swapped into without downloading it again", async () => {
  const { host, inst, updater, swapped } = await rig({ worker: false });
  writeFileSync(join(inst.dir, "VERSION"), "1.1.0");
  await updater.onRelease("1.1.0");
  expect(swapped).toEqual(["1.1.0"]);
  expect(host.hits).toEqual([]);
});

test("the swap hook failing is logged and does not undo the install", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  const logs: string[] = [];
  const cfg = host.config(inst, key, { log: (m) => void logs.push(m), sleep: noWait });
  await host.publishTs(key, "1.1.0");
  const u = new Updater(cfg, {
    swap: () => {
      throw new Error("no window");
    },
  });
  await u.onRelease("1.1.0");
  expect(u.state()).toEqual({ t: "installed", v: "1.1.0" });
  expect(logs.some((l) => l.includes("restart into 1.1.0 failed: no window"))).toBe(true);
});

test("restoring the previous version puts it back and restarts into it", async () => {
  const { key, host, inst, updater, swapped } = await rig({ worker: false });
  await host.publishTs(key, "1.1.0");
  await updater.onRelease("1.1.0");
  expect(await updater.restorePrevious()).toBe("1.0.0");
  expect(swapped).toEqual(["1.1.0", "1.0.0"]);
  expect(readInstalled(inst.dir)).toBe("1.0.0");
  expect(updater.info().skipped).toBe("1.1.0");
});

test("an Update asked for before any release is known checks, installs and says so meanwhile", async () => {
  const { key, host, updater, swapped } = await rig({ worker: false });
  expect(updater.asked()).toBe(false);
  await host.publishTs(key, "1.1.0");
  await updater.checkAndInstall();
  expect(swapped).toEqual(["1.1.0"]);
  expect(updater.asked()).toBe(false);
});

test("nothing newer after all: up to date", async () => {
  const { host, updater } = await rig({ worker: false });
  host.latest = "1.0.0";
  await updater.check();
  expect(updater.state()).toEqual({ t: "upToDate" });
  expect(updater.info().status).toBe("up to date");
});
