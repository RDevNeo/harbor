import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Updater } from "../src/delivery.ts";
import { install } from "../src/install.ts";
import { APK, APK_VERSION, NO_BROWSER, VIDEO_LIB, apk, browserUnsupported, engineStale, pendingExtras, putApk, retryAfter, videoStale } from "../src/extras.ts";
import { FakeHost, cleanup, configFor, makeInstall, makeKey, tmp } from "./support.ts";

afterEach(cleanup);

test("the_video_player_comes_only_when_it_changed: the video player comes only when it changed", () => {
  const d = tmp();
  expect(videoStale(d, "")).toBe(true);
  expect(videoStale(d, "abc")).toBe(true);
  writeFileSync(join(d, VIDEO_LIB), "x");
  writeFileSync(join(d, "video.installed"), "abc\n");
  expect(videoStale(d, "abc")).toBe(false);
  expect(videoStale(d, "def")).toBe(true);
  expect(videoStale(d, "")).toBe(false);
});

test("browser_engine_rules: the browser engine rules: missing, refreshed, kept after a restore, turned off, unsupported", () => {
  const cfg = configFor(null);
  expect(retryAfter(1)).toBe(300_000);
  expect(retryAfter(2)).toBe(600_000);
  expect(retryAfter(40)).toBe(6 * 3600 * 1000);
  expect(browserUnsupported(cfg)).toBeNull();
  expect(browserUnsupported({ ...cfg, glibc: () => [2, 39] })).toBeNull();
  expect(browserUnsupported({ ...cfg, glibc: () => [3, 0] })).toBeNull();
  expect(browserUnsupported({ ...cfg, glibc: () => [2, 38] })).toContain("this system has 2.38");
  expect(browserUnsupported({ ...cfg, glibc: () => null })).toContain("glibc-based");
  const dir = tmp();
  expect(engineStale(cfg, dir, "abc")).toBe(true);
  writeFileSync(join(dir, "harbor-browser"), "x");
  expect(engineStale(cfg, dir, "abc")).toBe(false);
  writeFileSync(join(dir, "browser.installed"), "abc\n");
  expect(engineStale(cfg, dir, "abc")).toBe(false);
  expect(engineStale(cfg, dir, "def")).toBe(true);
  writeFileSync(join(dir, NO_BROWSER), "");
  expect(engineStale(cfg, dir, "def")).toBe(false);
  expect(engineStale({ ...cfg, glibc: () => [2, 35] }, tmp(), "def")).toBe(false);
});

test("the phone app a PC serves, and one another PC served", () => {
  const dir = tmp();
  expect(apk(dir)).toBeNull();
  putApk(dir, new Uint8Array([1, 2, 3]), 108000);
  expect(apk(dir)).toEqual({ path: join(dir, APK), code: 108000 });
  expect(readFileSync(join(dir, APK_VERSION), "utf8")).toBe("108000");
  writeFileSync(join(dir, APK_VERSION), "junk");
  expect(apk(dir)?.code).toBe(0);
});

const tar = async (dir: string, name: string, files: Record<string, string>): Promise<Uint8Array> => {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(root, f), body);
  const out = join(dir, `${name}.tar.gz`);
  const p = Bun.spawn(["tar", "-czf", out, "-C", dir, name]);
  await p.exited;
  return new Uint8Array(await Bun.file(out).arrayBuffer());
};

test("a release's extras are fetched with the update and a failed one does not hold it back", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  const work = tmp();
  await host.publishTs(key, "1.1.0");
  const manifest = { version: "1.1.0", minRuntime: "1.0.0", runtime: "1.0.0", browser: { id: "b1", release: "1.1.0" }, video: { id: "v1", release: "1.1.0" }, apk: { code: 1001000, release: "1.1.0" } };
  await host.publish(key, "1.1.0", {
    "harbor-app.json": JSON.stringify(manifest),
    "harbor-browser-x86_64-linux.tar.gz": await tar(work, "harbor-browser-x86_64-linux", { "harbor-browser": "engine", "browser.id": "b1" }),
    [APK]: "apk bytes",
  });
  const logs: string[] = [];
  const cfg = host.config(inst, key, { log: (m) => void logs.push(m) });
  await install(cfg, "1.1.0");
  expect(readFileSync(join(inst.dir, "harbor-browser"), "utf8")).toBe("engine");
  expect(readFileSync(join(inst.dir, "browser.installed"), "utf8")).toBe("b1");
  expect(readFileSync(join(inst.dir, APK), "utf8")).toBe("apk bytes");
  expect(readFileSync(join(inst.dir, APK_VERSION), "utf8")).toBe("1001000");
  expect(existsSync(join(inst.dir, VIDEO_LIB))).toBe(false);
  expect(logs.some((l) => l.startsWith("video not updated: download failed"))).toBe(true);
  expect(readFileSync(join(inst.dir, "VERSION"), "utf8")).toBe("1.1.0");
  expect(pendingExtras(cfg, inst.dir, { ...manifest }).map((w) => w.name)).toEqual(["video"]);
});

test("an installed copy without its player fetches it by itself and retries later when that fails", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  const work = tmp();
  writeFileSync(join(inst.dir, "manifest.json"), JSON.stringify({ version: "1.0.0", minRuntime: "1.0.0", runtime: "1.0.0", video: { id: "v1", release: "1.0.0" } }));
  let clock = 0;
  const cfg = host.config(inst, key, { now: () => clock });
  const u = new Updater(cfg);
  await u.autoExtras();
  expect(existsSync(join(inst.dir, VIDEO_LIB))).toBe(false);
  const tries = host.hits.length;
  await u.autoExtras();
  expect(host.hits.length).toBe(tries);
  await host.publish(key, "1.0.0", { "harbor-video-x86_64-linux.tar.gz": await tar(work, "harbor-video-x86_64-linux", { [VIDEO_LIB]: "mpv", "video.id": "v1" }) });
  clock += retryAfter(1);
  await u.autoExtras();
  expect(readFileSync(join(inst.dir, VIDEO_LIB), "utf8")).toBe("mpv");
  expect(readFileSync(join(inst.dir, "video.installed"), "utf8")).toBe("v1");
});

test("Install engine turns a --no-browser copy back on and reports the result", async () => {
  const key = await makeKey();
  const host = new FakeHost();
  const inst = makeInstall();
  const work = tmp();
  writeFileSync(join(inst.dir, NO_BROWSER), "");
  writeFileSync(join(inst.dir, "manifest.json"), JSON.stringify({ version: "1.0.0", minRuntime: "1.0.0", runtime: "1.0.0", browser: { id: "b1", release: "1.0.0" } }));
  const u = new Updater(host.config(inst, key));
  expect(u.browserNeeded()).toBe("off");
  await u.installBrowser();
  expect(u.browserResult()).toMatchObject({ ok: false });
  await host.publish(key, "1.0.0", { "harbor-browser-x86_64-linux.tar.gz": await tar(work, "harbor-browser-x86_64-linux", { "harbor-browser": "engine" }) });
  await u.installBrowser();
  expect(u.browserResult()).toEqual({ ok: true });
  expect(u.browserNeeded()).toBe("ok");
  expect(u.browserInstalling()).toBe(false);
  expect(existsSync(join(inst.dir, NO_BROWSER))).toBe(false);
});
