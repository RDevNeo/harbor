import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Updater } from "../src/delivery.ts";
import { install } from "../src/install.ts";
import { APK, APK_VERSION, VIDEO_LIB, apk, dropBrowser, pendingExtras, putApk, retryAfter, videoStale } from "../src/extras.ts";
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

test("failed extras are retried later, up to every six hours", () => {
  expect(retryAfter(1)).toBe(300_000);
  expect(retryAfter(2)).toBe(600_000);
  expect(retryAfter(40)).toBe(6 * 3600 * 1000);
});

test("the old built-in browser's engine, its marks and its rollback copy are removed, once", () => {
  const dir = tmp();
  const prev = join(dir, ".previous");
  mkdirSync(join(dir, ".staging-browser"), { recursive: true });
  mkdirSync(prev);
  for (const f of ["harbor-browser", "browser.installed", "browser.id", ".no-browser", VIDEO_LIB]) writeFileSync(join(dir, f), "x");
  writeFileSync(join(prev, "harbor-browser"), "x");
  expect(dropBrowser(dir, prev)).toBe(true);
  for (const f of ["harbor-browser", "browser.installed", "browser.id", ".no-browser", ".staging-browser"]) expect(existsSync(join(dir, f))).toBe(false);
  expect(existsSync(join(prev, "harbor-browser"))).toBe(false);
  expect(existsSync(join(dir, VIDEO_LIB))).toBe(true);
  expect(dropBrowser(dir, prev)).toBe(false);
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
  // An older release's manifest names a browser engine too: nothing fetches it any more.
  const manifest = { version: "1.1.0", minRuntime: "1.0.0", runtime: "1.0.0", browser: { id: "b1", release: "1.1.0" }, video: { id: "v1", release: "1.1.0" }, apk: { code: 1001000, release: "1.1.0" } };
  await host.publish(key, "1.1.0", {
    "harbor-app.json": JSON.stringify(manifest),
    "harbor-browser-x86_64-linux.tar.gz": await tar(work, "harbor-browser-x86_64-linux", { "harbor-browser": "engine", "browser.id": "b1" }),
    [APK]: "apk bytes",
  });
  const logs: string[] = [];
  // The video player is Linux's only (extras.ts): this release is for Linux whatever runs the test.
  const cfg = host.config(inst, key, { os: "linux", log: (m) => void logs.push(m) });
  await install(cfg, "1.1.0");
  expect(existsSync(join(inst.dir, "harbor-browser"))).toBe(false);
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
  const cfg = host.config(inst, key, { os: "linux", now: () => clock });
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

test("an updated copy drops the old browser engine at its start", () => {
  const inst = makeInstall();
  writeFileSync(join(inst.dir, "harbor-browser"), "engine");
  writeFileSync(join(inst.dir, ".no-browser"), "");
  const logs: string[] = [];
  const u = new Updater(configFor(inst, { os: "linux", log: (m) => void logs.push(m) }));
  u.dropLeftovers();
  expect(existsSync(join(inst.dir, "harbor-browser"))).toBe(false);
  expect(existsSync(join(inst.dir, ".no-browser"))).toBe(false);
  u.dropLeftovers();
  expect(logs).toEqual(["removed the old built-in browser's engine"]);
});
